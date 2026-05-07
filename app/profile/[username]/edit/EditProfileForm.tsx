'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/app/context/AuthContext';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

interface UserProfile {
  real_name: string | null;
  bio: string | null;
  website_url: string | null;
  profile_image_url: string | null;
}

interface EditProfileFormProps {
  username: string;
}

export default function EditProfileForm({ username }: EditProfileFormProps) {
  const { user } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [profileImage, setProfileImage] = useState<File | null>(null);
  const [profileImagePreview, setProfileImagePreview] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    realName: '',
    bio: '',
    websiteUrl: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Check auth and ownership on mount
  useEffect(() => {
    if (!user) {
      router.push('/auth/login');
      return;
    }

    if (user.username !== username) {
      router.push(`/profile/${user.username}`);
      return;
    }

    // Load current profile data
    const loadProfileData = async () => {
      try {
        const response = await fetch(`/api/users/${username}`);
        if (!response.ok) throw new Error('Failed to load profile');

        const data = (await response.json()) as UserProfile;
        setFormData({
          realName: data.real_name || '',
          bio: data.bio || '',
          websiteUrl: data.website_url || '',
        });
        if (data.profile_image_url) {
          setProfileImagePreview(data.profile_image_url);
        }
      } catch (err) {
        console.error('Error loading profile:', err);
        setError('Failed to load profile data');
      } finally {
        setLoading(false);
      }
    };

    loadProfileData();
  }, [user, username, router]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    if (file) {
      setProfileImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfileImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.currentTarget;
    setFormData(prev => ({
      ...prev,
      [name === 'realName' ? 'realName' : name === 'bio' ? 'bio' : 'websiteUrl']: value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      const token = localStorage.getItem('auth_token');
      if (!token) {
        setError('No authentication token found. Please log in again.');
        setSubmitting(false);
        return;
      }

      const formDataToSend = new FormData();
      formDataToSend.append('real_name', formData.realName);
      formDataToSend.append('bio', formData.bio);
      formDataToSend.append('website_url', formData.websiteUrl);
      if (profileImage) {
        formDataToSend.append('profile_image', profileImage);
      }

      const response = await fetch('/api/me/profile', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formDataToSend,
      });

      if (!response.ok) {
        let errorMessage = 'Failed to update profile';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } catch (e) {
          // If response body is not JSON, use default message
        }
        throw new Error(errorMessage);
      }

      setSuccess(true);
      setTimeout(() => {
        router.push(`/profile/${username}`);
      }, 1500);
    } catch (err) {
      console.error('Error updating profile:', err);
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white py-12">
      <div className="max-w-2xl mx-auto px-4">
        <h1 className="text-4xl font-bold mb-8">Edit Profile</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Profile Image */}
          <div>
            <label className="block text-sm font-semibold mb-4">Profile Image</label>
            <div className="flex items-center gap-6">
              {profileImagePreview ? (
                <Image
                  src={profileImagePreview}
                  alt="Profile preview"
                  width={120}
                  height={120}
                  className="rounded-full w-30 h-30 object-cover"
                />
              ) : (
                <div className="w-30 h-30 bg-gray-800 rounded-full flex items-center justify-center">
                  <span className="text-gray-500">No image</span>
                </div>
              )}
              <div className="flex-1">
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  className="block w-full text-sm text-gray-400
                    file:mr-4 file:py-2 file:px-4
                    file:rounded-lg file:border-0
                    file:text-sm file:font-semibold
                    file:bg-blue-600 file:text-white
                    hover:file:bg-blue-700
                  "
                />
                <p className="text-xs text-gray-500 mt-2">
                  Max 5MB. Recommended: 400x400px
                </p>
              </div>
            </div>
          </div>

          {/* Real Name */}
          <div>
            <label htmlFor="realName" className="block text-sm font-semibold mb-2">
              Real Name
            </label>
            <input
              type="text"
              id="realName"
              name="realName"
              value={formData.realName}
              onChange={handleInputChange}
              maxLength={100}
              className="w-full px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Your name"
            />
          </div>

          {/* Bio */}
          <div>
            <label htmlFor="bio" className="block text-sm font-semibold mb-2">
              Bio
            </label>
            <textarea
              id="bio"
              name="bio"
              value={formData.bio}
              onChange={handleInputChange}
              maxLength={500}
              rows={4}
              className="w-full px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Tell us about yourself"
            />
            <p className="text-xs text-gray-500 mt-2">
              {formData.bio.length}/500 characters
            </p>
          </div>

          {/* Website */}
          <div>
            <label htmlFor="websiteUrl" className="block text-sm font-semibold mb-2">
              Website
            </label>
            <input
              type="text"
              id="websiteUrl"
              name="websiteUrl"
              value={formData.websiteUrl}
              onChange={handleInputChange}
              className="w-full px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="https://example.com"
            />
          </div>

          {/* Error Message */}
          {error && (
            <div className="bg-red-900/20 border border-red-700 text-red-400 rounded-lg p-3">
              {error}
            </div>
          )}

          {/* Success Message */}
          {success && (
            <div className="bg-green-900/20 border border-green-700 text-green-400 rounded-lg p-3">
              Profile updated successfully! Redirecting...
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-6 border-t border-gray-700">
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed font-semibold rounded-lg transition"
            >
              {submitting ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              className="flex-1 px-6 py-3 bg-gray-800 hover:bg-gray-700 font-semibold rounded-lg transition"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
